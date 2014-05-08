#!/usr/bin/python

# WARNING : Running this script requires root privileges

# README : With this script, the user is able, while having root privileges, to add a service to the /etc/avahi/services/ folder. 
#          The newly created service will have argv[1] as its name and argv[2] as its port.

import os
import sys


filename = str(sys.argv[1])+'.service' # file name is the first cmd line argument
path = '/etc/avahi/services/'+filename # create path to the /etc/avahi/services/ folder

os.system('sudo touch '+path) # create file with root privileges

target = open(path, 'w')

line1 = '<?xml version="1.0" standalone=\'no\'?>'
line2 = '<!DOCTYPE service-group SYSTEM "avahi-service.dtd">'
line3 = '<service-group>'
line4 = '  <name replace-wildcards="yes">'+str(sys.argv[1])+'</name>'
line4 = '  <service>'
line5 = '    <type>_'+str(sys.argv[1])+'._tcp</type>'
line6 = '    <port>'+sys.argv[2]+'</port>' # port number is the second cmd line argument
line7 = '    <txt-record>path=/data/shared/Music</txt-record>' # This line should be changed...not realy sure of what to put here.
line8 = '  </service>'
line9 = '</service-group>'


target.write(line1)
target.write("\n")
target.write(line2)
target.write("\n")
target.write(line3)
target.write("\n")
target.write(line4)
target.write("\n")
target.write(line5)
target.write("\n")
target.write(line6)
target.write("\n")
target.write(line7)
target.write("\n")
target.write(line8)
target.write("\n")
target.write(line9)
target.write("\n")

target.close()





